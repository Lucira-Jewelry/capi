'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, getToken, setToken, setUnauthorizedHandler } from './api';

interface Auth {
  /** False until the saved token has been looked up (it lives in the browser, so the first render cannot know). */
  ready: boolean;
  signedIn: boolean;
  signIn: (token: string) => Promise<string | null>;
  signOut: () => void;
}

const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getToken()));
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setSignedIn(false);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, [signOut]);

  const signIn = useCallback(async (token: string): Promise<string | null> => {
    try {
      await api('GET', '/me', undefined, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return 'That token is not right.';
      if (e instanceof ApiError && e.status === 429) return e.message;
      return 'Could not reach the server.';
    }
    setToken(token);
    setSignedIn(true);
    return null;
  }, []);

  const value = useMemo(() => ({ ready, signedIn, signIn, signOut }), [ready, signedIn, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
