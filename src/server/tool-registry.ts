import { TOOL_HANDLERS, type ToolName } from '../tools/index.js';

export function hasTool(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name);
}

export function getToolHandler(name: ToolName) {
  return TOOL_HANDLERS[name];
}

export function listRegisteredTools(): ToolName[] {
  return Object.keys(TOOL_HANDLERS) as ToolName[];
}

export type { ToolName };
