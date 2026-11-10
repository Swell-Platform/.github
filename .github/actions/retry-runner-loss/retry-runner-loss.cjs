module.exports = async ({ github, context, core, policies }) => {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const runId = context.payload.workflow_run?.id;
  if (context.eventName !== "workflow_run" || !runId) {
    core.notice("Recovery requires a completed workflow_run event.");
    return;
  }

  const { data: run } = await github.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });
  const policy = policies[run.path.split("@")[0]];
  const eligibleRun = (candidate) =>
    candidate.status === "completed" &&
    ["failure", "cancelled"].includes(candidate.conclusion) &&
    candidate.run_attempt === 1 &&
    candidate.head_repository?.full_name === repository;
  if (!policy || !policy.events.includes(run.event) || !eligibleRun(run)) {
    core.notice("Skipping a run that is not eligible for recovery.");
    return;
  }

  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRun,
    {
      owner,
      repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
    }
  );
  const jobNames = [
    ...policy.jobs,
    policy.dependencyGate,
    policy.supersessionJob,
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const baseName = (job) =>
    jobNames.find((name) => job.name === name) ??
    jobNames.find((name) => job.name.startsWith(`${name} (`)) ??
    job.name;
  let preview;
  if (policy.pullRequestLabel) {
    const match = jobs
      .map((job) =>
        job.name.match(/^browser-smoke \(PR #([1-9]\d*) @ ([a-f0-9]{40})\)$/)
      )
      .find(Boolean);
    if (!match || run.display_title !== `ephemeral-pr-${match[1]}`) {
      core.notice(
        "Skipping a preview without its original pull request and commit identity."
      );
      return;
    }
    preview = { number: Number(match[1]), sha: match[2] };
  }

  const sourceIsCurrent = async () => {
    if (run.event === "pull_request" || preview) {
      const number =
        preview?.number ??
        (run.pull_requests?.length === 1
          ? run.pull_requests[0].number
          : undefined);
      if (
        !number ||
        (run.event === "pull_request" &&
          (run.pull_requests?.length !== 1 ||
            run.pull_requests[0].number !== number))
      ) {
        core.notice("Skipping a run without one associated pull request.");
        return false;
      }
      const { data: pr } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      if (
        pr.state !== "open" ||
        pr.head.repo?.full_name !== repository ||
        pr.labels.some((label) => label.name === "OH CRAP") ||
        pr.head.sha !== (preview?.sha ?? run.head_sha) ||
        (!preview && pr.head.ref !== run.head_branch) ||
        (policy.pullRequestLabel &&
          !pr.labels.some((label) => label.name === policy.pullRequestLabel))
      ) {
        core.notice(
          "Skipping a closed, disabled, forked, or superseded pull request."
        );
        return false;
      }
    }

    if (run.event !== "pull_request") {
      if (
        ["push", "schedule"].includes(run.event) &&
        run.head_branch !== context.payload.repository.default_branch
      ) {
        core.notice(
          "Recovery is limited to the default branch for push and scheduled runs."
        );
        return false;
      }
      let branch;
      try {
        ({ data: branch } = await github.rest.repos.getBranch({
          owner,
          repo,
          branch: run.head_branch,
        }));
      } catch (error) {
        if (error.status !== 404) throw error;
        core.notice("Skipping a branch that no longer exists.");
        return false;
      }
      if (branch.commit.sha !== run.head_sha) {
        core.notice("Skipping a superseded branch commit.");
        return false;
      }
    }
    return true;
  };
  if (!(await sourceIsCurrent())) return;

  const runnerLoss =
    /lost communication with the server|the runner has received a shutdown signal/i;
  const intentionalStop =
    /the run was cancel(?:ed|led) by @|higher priority waiting request|exceeded the maximum execution time/i;
  const interrupted = [];
  for (const job of jobs.filter((job) =>
    ["failure", "cancelled"].includes(job.conclusion)
  )) {
    const dependencyGate =
      baseName(job) === policy.dependencyGate &&
      job.steps?.some(
        (step) => step.name === "Check results" && step.conclusion === "failure"
      );
    const spotJob =
      policy.jobs.includes(baseName(job)) &&
      job.labels?.some((label) => label.endsWith("-spot"));
    if (!spotJob && !dependencyGate) {
      core.notice(
        `Skipping recovery: ${job.name} is outside the eligible Spot jobs.`
      );
      return;
    }
    if (!job.check_run_url) {
      core.notice(`Skipping recovery: no check-run evidence for ${job.name}.`);
      return;
    }

    const annotations = await github.paginate(
      github.rest.checks.listAnnotations,
      {
        owner,
        repo,
        check_run_id: Number(
          new URL(job.check_run_url).pathname.split("/").pop()
        ),
        per_page: 100,
      }
    );
    let messages = annotations
      .map((annotation) => annotation.message)
      .join("\n");
    if (
      job.conclusion === "cancelled" ||
      (!runnerLoss.test(messages) &&
        /the operation was cancel(?:ed|led)/i.test(messages))
    ) {
      try {
        const { data: logs } =
          await github.rest.actions.downloadJobLogsForWorkflowRun({
            owner,
            repo,
            job_id: job.id,
          });
        messages += `\n${logs}`;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (intentionalStop.test(messages)) {
      core.notice("Skipping an intentional cancellation or timeout.");
      return;
    }
    if (spotJob && runnerLoss.test(messages)) {
      interrupted.push(job.name);
    } else if (!dependencyGate) {
      core.notice(
        `Skipping recovery: ${job.name} has no confirmed runner loss.`
      );
      return;
    }
  }
  if (!interrupted.length) {
    core.notice("No eligible jobs have confirmed runner loss.");
    return;
  }

  const newerRuns = await github.paginate(
    github.rest.actions.listWorkflowRuns,
    {
      owner,
      repo,
      workflow_id: run.workflow_id,
      created: `>=${run.created_at}`,
      per_page: 100,
      ...(preview
        ? {}
        : {
            event: run.event,
            branch: run.head_branch,
            head_sha: run.head_sha,
          }),
    }
  );
  const deadline = Date.now() + 60_000;
  for (const newer of newerRuns.filter(
    (candidate) =>
      candidate.id > runId &&
      candidate.head_repository?.full_name === repository &&
      (preview
        ? candidate.display_title === run.display_title
        : run.event !== "pull_request" ||
          candidate.pull_requests?.some(
            (pr) => pr.number === run.pull_requests[0].number
          ))
  )) {
    while (true) {
      const newerJobs = await github.paginate(
        github.rest.actions.listJobsForWorkflowRun,
        {
          owner,
          repo,
          run_id: newer.id,
          filter: "latest",
          per_page: 100,
        }
      );
      const initialJob = newerJobs.find(
        (job) => baseName(job) === policy.supersessionJob
      );
      if (initialJob?.conclusion === "skipped") break;
      if (initialJob?.conclusion || initialJob?.status === "in_progress") {
        core.notice("Skipping a run superseded by a newer workflow run.");
        return;
      }
      if (Date.now() >= deadline) {
        core.setFailed("Timed out waiting for the newer workflow state.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const { data: current } = await github.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });
  if (!eligibleRun(current) || !(await sourceIsCurrent())) {
    core.notice(
      "The run or its source changed while inspecting failures; skipping recovery."
    );
    return;
  }
  await github.rest.actions.reRunWorkflowFailedJobs({
    owner,
    repo,
    run_id: runId,
  });
  core.notice(
    `Requested one failed-job rerun for runner loss in: ${interrupted.join(
      ", "
    )}.`
  );
};
