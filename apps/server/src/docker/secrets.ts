/**
 * Secrets outside the environment (H8, #91). A Container's command, entrypoint, labels and
 * mount sources are written by whoever built or ran it, and often carry a password or token:
 * `--requirepass …`, a Traefik basic-auth label, a database URL, `/run/secrets/…`. Values that
 * look like secrets are masked before anything leaves for the browser, and each one is
 * revealed on its own, logged by where it sits and never by its value, as environment values
 * are (FR-20).
 *
 * This is a heuristic: it errs towards masking, because a masked value costs one click and a
 * shown one cannot be taken back.
 */
import {
  SECRET_MASK,
  type ContainerDetail,
  type ContainerMount,
  type ContainersSnapshot,
  type ContainerSummary,
  type SecretField,
} from '@lookout/shared';
import type { InspectedContainer } from './parse.ts';

/** A name (flag, variable, label segment, path segment) that says what follows is secret. */
const SECRET_NAME =
  /pass(word|wd|phrase)?|pwd|secret|token|credential|api[-_.]?key|access[-_.]?key|private[-_.]?key|^key$|bearer|dsn|cookie|basicauth|digestauth|htpasswd/i;

/**
 * The longest value checked for a secret (#117, X1b). A longer one is masked without being
 * looked at: no real label, argument or path is that long, and checking costs time.
 */
export const MAX_CHECKED_VALUE_CHARS = 8 * 1024;

/** A password hash: `$apr1$`, `$2y$`, `$argon2id$`, `$6$`… */
const PASSWORD_HASH = /\$(apr1|2[abxy]?|argon2(id|i|d)?|[156])\$/;

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
/** Ends the user-info part of a URL. */
const USERINFO_END = /[\s/@]/;

/**
 * True if the value holds a URL with a password, `scheme://user:password@`. A hand-written
 * scan rather than a regular expression (#117): `[a-z][a-z0-9+.-]*:\/\/…` unanchored backtracks
 * quadratically on a long run of letters, and labels are written by whoever built the Image.
 * Each character is visited a bounded number of times: a scheme's scan stops at the `:` of
 * the `://` before it, and the user-info's at the `/` of the `://` after it.
 */
function hasUrlWithPassword(value: string): boolean {
  let from = 0;
  for (;;) {
    const at = value.indexOf('://', from);
    if (at < 0) return false;
    from = at + 3;
    // The scheme: scheme characters right before "://", at least one of them a letter.
    let start = at;
    let letter = false;
    while (start > 0 && SCHEME_CHAR.test(value[start - 1]!)) {
      start--;
      if (LETTER.test(value[start]!)) letter = true;
    }
    if (!letter) continue;
    // user:password@, with no whitespace, "/" or "@" before the "@", and a non-empty password.
    let colon = -1;
    for (let i = from; i < value.length; i++) {
      const char = value[i]!;
      if (char === '@') {
        if (colon >= 0 && i > colon + 1) return true;
        break;
      }
      if (USERINFO_END.test(char)) break;
      if (char === ':' && colon < 0) colon = i;
    }
  }
}

export function looksSecretName(name: string): boolean {
  return name.length > MAX_CHECKED_VALUE_CHARS || SECRET_NAME.test(name);
}

/** A value that is a secret whatever it is called: a URL with a password, or a hash. */
export function looksSecretValue(value: string): boolean {
  if (value.length > MAX_CHECKED_VALUE_CHARS) return true;
  return hasUrlWithPassword(value) || PASSWORD_HASH.test(value);
}

/** A label is secret if its last dotted segment says so (or it is `…auth.users`), or its value does. */
function secretLabel(key: string, value: string): boolean {
  const last = key.slice(key.lastIndexOf('.') + 1);
  return looksSecretName(last) || /auth\.users$/i.test(key) || looksSecretValue(value);
}

/** One argument, masked where it carries a secret, or null if it carries none. */
function maskArgument(arg: string, previous: string | undefined): string | null {
  // "--flag value": the flag before this argument named a secret.
  if (previous !== undefined && /^-{1,2}[^=\s]+$/.test(previous) && looksSecretName(previous)) {
    return SECRET_MASK;
  }
  // "--flag=value" or "NAME=value".
  const equals = arg.indexOf('=');
  if (equals > 0 && !/\s/.test(arg.slice(0, equals)) && looksSecretName(arg.slice(0, equals))) {
    return `${arg.slice(0, equals + 1)}${SECRET_MASK}`;
  }
  if (looksSecretValue(arg)) return SECRET_MASK;
  // A shell line in one argument (sh -c "redis-server --requirepass …"): mask word by word.
  if (/\s/.test(arg)) {
    const words = arg.split(/\s+/);
    const masked = words.map((word, i) => maskArgument(word, words[i - 1]));
    if (masked.every((result) => result === null)) return null;
    return masked.map((result, i) => result ?? words[i]).join(' ');
  }
  return null;
}

/** Arguments with secrets masked, and the indexes that were. */
export function maskArguments(args: string[]): { shown: string[]; masked: number[] } {
  const masked: number[] = [];
  const shown = args.map((arg, i) => {
    const result = maskArgument(arg, args[i - 1]);
    if (result === null) return arg;
    masked.push(i);
    return result;
  });
  return { shown, masked };
}

/** Labels with secret values masked, and the keys that were. */
export function maskLabels(labels: Record<string, string>): {
  shown: Record<string, string>;
  masked: string[];
} {
  const shown: Record<string, string> = {};
  const masked: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (secretLabel(key, value)) {
      shown[key] = SECRET_MASK;
      masked.push(key);
    } else {
      shown[key] = value;
    }
  }
  return { shown, masked };
}

function secretMountSource(source: string): boolean {
  return (
    source.split('/').some((segment) => segment && looksSecretName(segment)) ||
    looksSecretValue(source)
  );
}

export function maskMounts(mounts: ContainerMount[]): {
  shown: ContainerMount[];
  masked: number[];
} {
  const masked: number[] = [];
  const shown = mounts.map((mount, i) => {
    if (!secretMountSource(mount.source)) return mount;
    masked.push(i);
    return { ...mount, source: SECRET_MASK };
  });
  return { shown, masked };
}

/** A list row as the browser gets it: secret label values masked. */
export function publicSummary(summary: ContainerSummary): ContainerSummary {
  const labels = maskLabels(summary.labels);
  return { ...summary, labels: labels.shown, maskedLabels: labels.masked };
}

export function publicSnapshot(snapshot: ContainersSnapshot): ContainersSnapshot {
  return { ...snapshot, containers: snapshot.containers.map(publicSummary) };
}

/** The detail as the browser gets it: environment names only, and secrets masked. */
export function publicDetail(container: InspectedContainer): ContainerDetail {
  const { env, ...rest } = container;
  const command = maskArguments(container.command);
  const entrypoint = maskArguments(container.entrypoint);
  const mounts = maskMounts(container.mounts);
  const labels = maskLabels(container.labels);
  return {
    ...rest,
    labels: labels.shown,
    maskedLabels: labels.masked,
    command: command.shown,
    entrypoint: entrypoint.shown,
    mounts: mounts.shown,
    envNames: env.map((variable) => variable.name),
    masked: { command: command.masked, entrypoint: entrypoint.masked, mounts: mounts.masked },
  };
}

/**
 * The real value behind one masked item, or null if there is no masked item there. Only a
 * masked item can be asked for: anything else is already on screen.
 */
export function secretValue(
  container: InspectedContainer,
  field: SecretField,
  key: string,
): string | null {
  if (field === 'label') {
    const value = Object.hasOwn(container.labels, key) ? container.labels[key] : undefined;
    return value !== undefined && secretLabel(key, value) ? value : null;
  }
  if (!/^(0|[1-9]\d{0,4})$/.test(key)) return null;
  const index = Number(key);
  if (field === 'mount') {
    const mount = container.mounts[index];
    return mount && secretMountSource(mount.source) ? mount.source : null;
  }
  const args = field === 'command' ? container.command : container.entrypoint;
  return maskArguments(args).masked.includes(index) ? args[index]! : null;
}
