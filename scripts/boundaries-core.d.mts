export interface BoundaryFile {
  path: string;
  content: string;
}
export interface BoundaryViolation {
  path: string;
  spec: string;
  rule: string;
}
export declare function extractImports(content: string): string[];
export declare function checkBoundaries(files: BoundaryFile[]): BoundaryViolation[];
