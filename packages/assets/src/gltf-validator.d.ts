declare module 'gltf-validator' {
  export interface ValidatorMessage {
    code: string;
    message: string;
    severity: 0 | 1 | 2 | 3;
    pointer?: string;
  }

  export interface ValidatorReport {
    uri?: string;
    mimeType?: string;
    validatorVersion: string;
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidatorMessage[];
      truncated?: boolean;
    };
    info?: unknown;
  }

  export interface ValidatorOptions {
    uri?: string;
    format?: 'glb' | 'gltf';
    writeTimestamp?: boolean;
    maxIssues?: number;
    ignoredIssues?: string[];
    onlyIssues?: string[];
    severityOverrides?: Record<string, 0 | 1 | 2 | 3>;
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
  }

  export function version(): string;
  export function validateBytes(
    data: Uint8Array,
    options?: ValidatorOptions,
  ): Promise<ValidatorReport>;
}
