import { FolderOpen, Plus, X } from 'lucide-react';
import { IconButton } from './IconButton';

export type RecentProject = { root: string; name: string };

export function ProjectPicker({
  projects,
  onOpen,
  onNew,
  onClose,
}: {
  projects: RecentProject[];
  onOpen: (root: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop project-picker-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="project-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-picker-title"
      >
        <div className="dialog-heading">
          <h2 id="project-picker-title">打开阅读项目</h2>
          <IconButton label="关闭项目选择" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <p className="project-picker-hint">选择最近使用的项目，或新建一个项目。</p>
        {projects.length ? (
          <div className="recent-projects" role="list" aria-label="最近项目">
            {projects.map((project) => (
              <button
                key={project.root}
                className="recent-project"
                onClick={() => onOpen(project.root)}
              >
                <FolderOpen size={18} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.root}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="recent-projects-empty">还没有最近项目</div>
        )}
        <button className="primary-button project-picker-new" onClick={onNew}>
          <Plus size={17} />
          新建项目（选择文件夹）
        </button>
      </section>
    </div>
  );
}
