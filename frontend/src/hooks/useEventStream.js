import { useEffect, useRef } from 'react';
import { openEventStream } from '../api/client';

/**
 * Subscribe to the backend SSE stream.
 *
 * The handler is kept in a ref so a caller can pass an inline arrow function
 * without tearing down and re-opening the connection on every render.
 */
export function useEventStream(onEvent) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const source = openEventStream();

    const forward = (e) => {
      try {
        handlerRef.current?.(JSON.parse(e.data));
      } catch { /* ignore malformed frames */ }
    };

    for (const name of ['message.inbound', 'message.outbound', 'message.ack', 'connection.status']) {
      source.addEventListener(name, forward);
    }

    return () => source.close();
  }, []);
}
