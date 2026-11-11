export interface MsaCode {
  userCode: string | null
  verificationUri: string | null
  message: string | null
  expiresIn: number | null
}

export interface MsaJob {
  state: string
  code: MsaCode | null
  error: string | null
  startedAt: number
  finishedAt: number | null
  result: { name: string; uuid: string; hasCerts: boolean } | null
}

export interface MsaSession {
  accessToken: string
  selectedProfile: { id: string; name: string }
  availableProfiles: { id: string; name: string }[]
  certificates?: unknown
}

export function msaJobOf(innerID: string): MsaJob | null
export function msaJobStart(input: { innerID: string; email: string; cacheDir: string; onDone?: ((profile: { name: string; uuid: string; hasCerts: boolean }) => void) | null }): MsaJob
export function msaSession(input: { email: string; cacheDir: string }): Promise<MsaSession>
export function msaSupported(): boolean
