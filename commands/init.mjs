import { runAgentThroughCore } from './agent.mjs';

/**
 * zuku|zukujs init ["game request"] [--name <name>] [--model <provider/model>] [--yolo | --draft]
 *                  [--experimental]
 * Creates a NEW game in the current folder through Agent Core (`game.init`): the folder is
 * granted with purpose game.init and the Core's admitted new-game pipeline runs there.
 */
export default function init(args = [], context = {}) {
  return runAgentThroughCore(args, context, { force: 'init' });
}
