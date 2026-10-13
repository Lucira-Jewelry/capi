'use client';
import { useState, type FormEvent } from 'react';
import { Button, Card } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export function Login() {
  const { signIn } = useAuth();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await signIn(token.trim()));
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="mx-auto mt-16 max-w-sm">
      <Card className="p-6">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Enter the admin token for this server.</p>
        <label htmlFor="token" className="mt-5 block text-sm font-medium">Admin token</label>
        <input id="token" type="password" autoComplete="current-password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
        {error && <p role="alert" className="mt-3 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !token.trim()} className="mt-5 w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
      </Card>
    </form>
  );
}
