export interface DockerTag {
  name: string;
}

export interface VersionEntry {
  postgres_version: string;
  postgres_major_version: string;
  is_latest: boolean;
  extension_template?: string;
  platforms: string[];
}

export interface VersionsFile {
  versions: VersionEntry[];
}
