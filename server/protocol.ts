// Trust boundary: everything a WebSocket client sends is `unknown` until it passes through here.
import type { ClientMsg } from '../shared/types.ts';
import { isRecord } from './util.ts';

/** Returns a well-formed message, or null for anything malformed or unknown. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case 'join':
      if (typeof raw.pin !== 'string') return null;
      return { t: 'join', pin: raw.pin, playerId: typeof raw.playerId === 'string' ? raw.playerId : undefined };
    case 'vote':
      if (typeof raw.pos !== 'number' || !Number.isInteger(raw.pos) || typeof raw.person !== 'string') return null;
      return { t: 'vote', pos: raw.pos, person: raw.person };
    case 'host':
      return typeof raw.key === 'string' ? { t: 'host', key: raw.key } : null;
    case 'history':
      return { t: 'history' };
    case 'action': {
      const action = raw.action;
      switch (action) {
        case 'newGame':
        case 'closeGame':
        case 'next':
        case 'endNow':
        case 'skip':
        case 'repeat':
        case 'finish':
          return { t: 'action', action };
        case 'addTime':
          return { t: 'action', action, seconds: typeof raw.seconds === 'number' ? raw.seconds : undefined };
        case 'settings':
          return {
            t: 'action',
            action,
            autoEndWhenAllVoted: typeof raw.autoEndWhenAllVoted === 'boolean' ? raw.autoEndWhenAllVoted : undefined,
          };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
