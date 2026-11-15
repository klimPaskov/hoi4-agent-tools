import { analysisTaskTools } from '../tools/analysis.js';
import { characterWriteTaskTools } from '../tools/character-write.js';
import { decisionWriteTaskTools } from '../tools/decision-write.js';
import { techWriteTaskTools } from '../tools/tech-write.js';
import { eventWriteTaskTools } from '../tools/event-write.js';
import { eventTaskTools } from '../tools/event.js';
import { focusTaskTools } from '../tools/focus.js';
import { guiTaskTools } from '../tools/gui.js';
import { ideaWriteTaskTools } from '../tools/idea-write.js';
import { localisationTaskTools } from '../tools/localisation-write.js';
import { mapTaskTools } from '../tools/map.js';
import { probabilityTaskTools } from '../tools/probability.js';
import { technologyTaskTools } from '../tools/technology.js';
import type { TaskToolDefinition } from './task-tool-definition.js';

export const taskToolCatalog: readonly TaskToolDefinition[] = [
  ...focusTaskTools,
  ...guiTaskTools,
  ...mapTaskTools,
  ...localisationTaskTools,
  ...ideaWriteTaskTools,
  ...characterWriteTaskTools,
  ...eventWriteTaskTools,
  ...decisionWriteTaskTools,
  ...techWriteTaskTools,
  ...eventTaskTools,
  ...analysisTaskTools,
  ...technologyTaskTools,
  ...probabilityTaskTools,
];
