import { createLucideIcon } from 'lucide-react';
import { penGrip, penOutline, penTip } from '../icons/pen-shape';

export const PenIcon = createLucideIcon('FolioPen', [
  ['path', { d: penOutline, key: 'body' }],
  ['path', { d: penGrip, key: 'grip' }],
  ['path', { d: penTip, key: 'tip' }],
]);
