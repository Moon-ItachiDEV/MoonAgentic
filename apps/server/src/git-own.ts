/**
 * Put before every git command the server runs in a project's folder. A repository's own
 * settings can name a command that git runs each time it looks at the files
 * (`core.fsmonitor`): listing or reading a folder must not run what that folder says.
 */
export const GIT_QUIET = ["-c", "core.fsmonitor=false"];

/**
 * The same for a program that runs git itself (`gh`), which only the environment reaches
 * (git 2.31 and later). Added after the settings `env` already carries this way.
 */
export function gitQuietEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${count}`]: "false",
  };
}
