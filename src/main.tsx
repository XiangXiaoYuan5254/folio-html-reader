import { createRoot } from 'react-dom/client';
import App from './App';
import './themes.css';
import './styles.css';
import './ai.css';
import './theme-styles.css';
import { applyTheme } from './theme';
// Lets the stylesheet leave room for the Windows caption buttons.
document.documentElement.dataset.platform =
  window.folio?.platform || (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'darwin' : 'win32');
applyTheme();
createRoot(document.getElementById('root')!).render(<App />);
