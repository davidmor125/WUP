import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api/client';

/** Fetch a path, optionally re-polling on an interval. */
export function useApi(path, { params = {}, enabled = true, interval = 0 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const fullPath = query ? `${path}?${query}` : path;

  const fetchData = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      setData(await apiFetch(fullPath));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fullPath, enabled]);

  useEffect(() => {
    fetchData();
    if (interval > 0) {
      const id = setInterval(fetchData, interval);
      return () => clearInterval(id);
    }
  }, [fetchData, interval]);

  return { data, loading, error, refetch: fetchData };
}
