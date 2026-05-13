export const writeCliStdout = (message: string): void => {
  process.stdout.write(message)
}

export const writeCliStderr = (message: string): void => {
  process.stderr.write(message)
}
