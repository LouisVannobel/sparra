type VerifiedMigratorArtifact=Readonly<{image_id:string}>
export function verifyMigratorArtifact(directory:string,commit:string,phase?:'release'|'candidate'):Promise<VerifiedMigratorArtifact>
export function migratorArtifactHashes(directory:string):Promise<Readonly<{lock_sha256:string;dockerfile_sha256:string;cli_sha256:string;reader_sha256:string;launcher_sha256:string;migration_source_sha256:string;archive_sha256:string;sbom_sha256:string}>>
