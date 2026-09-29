import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './ai.css';
// Lets the stylesheet leave room for the Windows caption buttons.
document.documentElement.dataset.platform = window.folio?.platform || 'web';
createRoot(document.getElementById('root')!).render(<App />);
