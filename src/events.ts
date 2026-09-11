// In-process event bus: every change people should see live (new post, comment, vote, agent, anchor)
// goes through here, and the SSE stream fans it out to connected browsers.
type Listener = (event: string, data: unknown) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function emit(event: string, data: unknown) {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch (e) {
      console.error("[events]", e);
    }
  }
}

export const listenerCount = () => listeners.size;
