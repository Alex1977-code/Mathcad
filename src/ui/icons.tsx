import type { ReactNode } from 'react';

const I = ({ children, title }: { children: ReactNode; title?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

export const IconNew = () => <I><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 12v6M9 15h6" /></I>;
export const IconOpen = () => <I><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" /><path d="M3 7v11a2 2 0 0 0 2 2h13l3-8H6l-3 8" /></I>;
export const IconSave = () => <I><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3M7 21v-7h10v7" /></I>;
export const IconExport = () => <I><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></I>;
export const IconImport = () => <I><path d="M12 15V3M7 10l5 5 5-5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></I>;
export const IconUndo = () => <I><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></I>;
export const IconRedo = () => <I><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></I>;
export const IconHelp = () => <I><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17h.01" /></I>;
export const IconSun = () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>;
export const IconMoon = () => <I><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></I>;
export const IconSettings = () => <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>;
export const IconMath = () => <I><path d="M4 7h7M7.5 3.5v7M4 17l5-5M4 12l5 5" /><path d="M14 9h6M14 15h6" /></I>;
export const IconText = () => <I><path d="M5 6V4h14v2M12 4v16M9 20h6" /></I>;
export const IconChart = () => <I><path d="M3 3v18h18" /><path d="M6 15c2-6 4-8 6-5s4 1 7-6" /></I>;
export const IconBreak = () => <I><path d="M4 12h3M10 12h4M17 12h3" /><path d="M6 4v4h12V4M6 20v-4h12v4" /></I>;
export const IconTrash = () => <I><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></I>;
export const IconAlignLeft = () => <I><path d="M4 3v18" /><rect x="7" y="6" width="12" height="4" rx="1" /><rect x="7" y="14" width="8" height="4" rx="1" /></I>;
export const IconAlignTop = () => <I><path d="M3 4h18" /><rect x="6" y="7" width="4" height="12" rx="1" /><rect x="14" y="7" width="4" height="8" rx="1" /></I>;
export const IconSeparate = () => <I><rect x="4" y="3" width="10" height="6" rx="1" /><rect x="10" y="15" width="10" height="6" rx="1" /><path d="M12 10v3m0 0-2-2m2 2 2-2" /></I>;
export const IconPanel = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></I>;
export const IconExample = () => <I><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></I>;
export const IconPrint = () => <I><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 14h12v7H6z" /></I>;
export const IconEdit = () => <I><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></I>;
export const IconCheck = () => <I><path d="M20 6 9 17l-5-5" /></I>;
export const IconClose = () => <I><path d="M18 6 6 18M6 6l12 12" /></I>;
export const IconImage = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></I>;
export const IconPlus = () => <I><path d="M12 5v14M5 12h14" /></I>;
export const IconChevron = () => <I><path d="m6 9 6 6 6-6" /></I>;
