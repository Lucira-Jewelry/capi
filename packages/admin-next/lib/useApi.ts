'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Loads once, keeps the last answer while reloading, and ignores an answer that arrives after the path changed. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const n = ++latest.current;
    setLoading(true);
    try {
      const r = await api<T>('GET', path);
      if (n === latest.current) { setData(r); setError(null); }
    } catch (e) {
      if (n === latest.current) setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (path === null) {
      latest.current++; // an answer still on its way for the old path must not land here
      setLoading(false);
      return;
    }
    void load();
  }, [path, load]);

  return { data, error, loading, reload: load };
}
