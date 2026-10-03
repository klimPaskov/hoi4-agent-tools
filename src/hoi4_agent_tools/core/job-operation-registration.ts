import type { CoreEngine } from './engine.js';
import { JobOperations } from './job-executor.js';
import { ServiceError } from './result.js';

/** Load one trusted domain after the authenticated job identifies its operation. */
export async function registerWorkerOperations(
  engine: CoreEngine,
  toolName: string,
): Promise<JobOperations> {
  const operations = new JobOperations();
  if (toolName.startsWith('hoi4.event_'))
    (await import('../event/job-operations.js')).registerEventJobs(operations, engine);
  else if (toolName.startsWith('hoi4.focus_'))
    (await import('../focus/job-operations.js')).registerFocusJobs(operations, engine);
  else if (toolName.startsWith('hoi4.gui_'))
    (await import('../gui/job-operations.js')).registerGuiJobs(operations, engine);
  else if (toolName.startsWith('hoi4.map_'))
    (await import('../map/job-operations.js')).registerMapJobs(operations, engine);
  else if (toolName.startsWith('hoi4.probability_'))
    (await import('../probability/job-operations.js')).registerProbabilityJobs(operations, engine);
  else if (toolName.startsWith('hoi4.tech_'))
    (await import('../technology/job-operations.js')).registerTechnologyJobs(operations, engine);
  else if (
    [
      'hoi4.impact_inspect',
      'hoi4.decision_inspect',
      'hoi4.mechanic_test',
      'hoi4.package_check',
      'hoi4.scenario_test',
    ].includes(toolName)
  )
    (await import('./analysis-job-operations.js')).registerAnalysisJobs(operations, engine);
  else
    throw new ServiceError(
      'JOB_OPERATION_UNAVAILABLE',
      'No trusted worker domain matches this job',
    );
  // A matching prefix never authorizes an unknown suffix or a client-selected module.
  operations.get(toolName);
  return operations;
}
