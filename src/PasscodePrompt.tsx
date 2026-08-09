import { useState } from "react";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import Logo from "./Logo";

interface Props {
  /** Store the key and retry. Resolves true on success, false if rejected. */
  onSubmit: (token: string) => Promise<boolean>;
}

/**
 * Shown when the server has a passcode and we don't yet hold a valid key.
 * Themed to match the app; on success App swaps this out for the full UI.
 */
export default function PasscodePrompt({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await onSubmit(token);
      if (!ok) setError("That passcode didn't work. Try again.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-gray-100 p-4 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      >
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <Logo className="h-10 w-10 text-blue-600 dark:text-blue-500" />
          <h1 className="text-lg font-semibold">Passcode required</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            This Sync Splat is protected. Enter the passcode shown in the
            server terminal, or scan its QR code.
          </p>
        </div>

        <label
          htmlFor="passcode"
          className="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-400"
        >
          Passcode
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-0 grid w-10 place-items-center text-gray-400 dark:text-gray-500">
            <LockClosedIcon className="size-5" aria-hidden="true" />
          </span>
          <input
            id="passcode"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-10 pr-3 text-gray-900 outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
          />
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || value.trim() === ""}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-400"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
