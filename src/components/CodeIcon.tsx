import { FileCode, FileJson, FileSpreadsheet, FileText } from 'lucide-react';
import { textType } from '../doc-kind';

// A code or text file's icon: a table for CSV, braces for JSON, lines for prose and logs.
export function CodeIcon(p: { path: string; size: number; className?: string }) {
  const type = textType(p.path);
  const Icon =
    type === 'csv' || type === 'tsv'
      ? FileSpreadsheet
      : type === 'json'
        ? FileJson
        : type === 'text' || type === 'plain'
          ? FileText
          : FileCode;
  return <Icon className={p.className} size={p.size} />;
}
