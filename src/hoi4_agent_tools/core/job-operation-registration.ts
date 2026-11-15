import type { CoreEngine } from './engine.js';
import { JobOperations } from './job-executor.js';
import { ServiceError } from './result.js';

const analysisTools = [
  'hoi4.impact_inspect',
  'hoi4.decision_inspect',
  'hoi4.mechanic_test',
  'hoi4.package_check',
  'hoi4.scenario_test',
];

/** The domain whose registration serves a tool, so a warm worker registers each domain once. */
export function workerDomain(toolName: string): string {
  if (analysisTools.includes(toolName)) return 'analysis';
  // The event writer registers apart from the inspect and render tools that share its prefix, so a
  // warm worker that served one of them still registers the other.
  if (toolName === 'hoi4.event_write') return 'event_write';
  if (toolName === 'hoi4.tech_write') return 'tech_write';
  const match = /^hoi4\.([a-z]+)_/u.exec(toolName);
  return match?.[1] ?? toolName;
}

/** Load one trusted domain after the authenticated job identifies its operation. */
export async function registerWorkerOperations(
  engine: CoreEngine,
  toolName: string,
): Promise<JobOperations> {
  const operations = new JobOperations();
  if (toolName === 'hoi4.event_write')
    (await import('../event/write-job-operations.js')).registerEventWriteJobs(operations, engine);
  else if (toolName === 'hoi4.tech_write')
    (await import('../technology/write-job-operations.js')).registerTechWriteJobs(
      operations,
      engine,
    );
  else if (toolName.startsWith('hoi4.event_'))
    (await import('../event/job-operations.js')).registerEventJobs(operations, engine);
  else if (toolName.startsWith('hoi4.focus_'))
    (await import('../focus/job-operations.js')).registerFocusJobs(operations, engine);
  else if (toolName.startsWith('hoi4.gui_'))
    (await import('../gui/job-operations.js')).registerGuiJobs(operations, engine);
  else if (toolName === 'hoi4.localisation_write')
    (await import('../localisation/job-operations.js')).registerLocalisationJobs(
      operations,
      engine,
    );
  else if (toolName === 'hoi4.idea_write')
    (await import('../ideas/job-operations.js')).registerIdeaWriteJobs(operations, engine);
  else if (toolName === 'hoi4.decision_write')
    (await import('../decision/write-job-operations.js')).registerDecisionWriteJobs(
      operations,
      engine,
    );
  else if (toolName === 'hoi4.doctrine_write')
    (await import('../doctrine/write-job-operations.js')).registerDoctrineWriteJobs(
      operations,
      engine,
    );
  else if (toolName === 'hoi4.character_write')
    (await import('../characters/job-operations.js')).registerCharacterWriteJobs(
      operations,
      engine,
    );
  else if (toolName.startsWith('hoi4.map_'))
    (await import('../map/job-operations.js')).registerMapJobs(operations, engine);
  else if (toolName.startsWith('hoi4.probability_'))
    (await import('../probability/job-operations.js')).registerProbabilityJobs(operations, engine);
  else if (toolName.startsWith('hoi4.tech_'))
    (await import('../technology/job-operations.js')).registerTechnologyJobs(operations, engine);
  else if (analysisTools.includes(toolName))
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
