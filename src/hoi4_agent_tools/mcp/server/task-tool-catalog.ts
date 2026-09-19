import { eventTaskTools } from '../tools/event.js';
import { focusTaskTools } from '../tools/focus.js';
import { guiTaskTools } from '../tools/gui.js';
import { mapTaskTools } from '../tools/map.js';
import { probabilityTaskTools } from '../tools/probability.js';
import { technologyTaskTools } from '../tools/technology.js';
import type { TaskToolDefinition } from './task-tool-definition.js';

export const taskToolCatalog: readonly TaskToolDefinition[] = [
  ...focusTaskTools,
  ...guiTaskTools,
  ...mapTaskTools,
  ...eventTaskTools,
  ...technologyTaskTools,
  ...probabilityTaskTools,
];
