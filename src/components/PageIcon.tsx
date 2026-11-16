import { useEffect, useState } from 'react';
import { LayoutDashboard, LibraryBig } from 'lucide-react';
import { pluginIcon } from '../plugins/store';

// The icon of a page tab: the library's, or its plugin's own (a plugin without one gets a
// dashboard's).
const icons = new Map<string, string>();
export function PageIcon({ id, size }: { id: string; size: number }) {
  const plugin = id.startsWith('plugin:') ? id.slice(7) : '';
  const [src, setSrc] = useState(() => icons.get(plugin) || '');
  useEffect(() => {
    if (!plugin || icons.has(plugin)) return;
    let live = true;
    pluginIcon(plugin)
      .then((icon) => {
        icons.set(plugin, icon || '');
        if (live) setSrc(icon || '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [plugin]);
  if (!plugin) return <LibraryBig size={size} />;
  return src ? (
    <img src={src} alt="" width={size} height={size} />
  ) : (
    <LayoutDashboard size={size} />
  );
}
