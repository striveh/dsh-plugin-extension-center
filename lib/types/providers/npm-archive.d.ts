import { type Sha256Digest } from '../domain/index.ts';
/** Stable P0 package-admission failures. */
export type MaterialAdmissionCode = 'archive-format' | 'archive-path' | 'archive-type' | 'bin-unclear' | 'dependencies-unsupported' | 'lifecycle-scripts' | 'manifest-invalid' | 'native-unsupported';
/** Structured refusal emitted before any owner mutation. */
export declare class MaterialAdmissionError extends Error {
    readonly code: MaterialAdmissionCode;
    constructor(code: MaterialAdmissionCode, message: string);
}
/** Safely admitted npm package metadata. */
export interface NpmPackageInspection {
    readonly name: string;
    readonly version: string;
    readonly binRelative: string | null;
    readonly files: readonly string[];
    readonly manifestBody: string;
    readonly manifestDigest: Sha256Digest;
    readonly fileManifestDigest: Sha256Digest;
    readonly scripts: readonly string[];
    readonly peerDependencies: Readonly<Record<string, string>>;
    readonly bundlePatch: Readonly<{
        path: string;
        body: string;
        digest: Sha256Digest;
    }> | null;
}
/** Inspect one npm archive without executing package code. */
export declare function inspectNpmArchive(path: string, expectedBin: string | null): Promise<NpmPackageInspection>;
/** Extract an already-admitted archive into a new center-owned immutable directory. */
export declare function materializeNpmArchive(archivePath: string, destination: string, expectedBin: string | null): Promise<NpmPackageInspection>;
//# sourceMappingURL=npm-archive.d.ts.map
