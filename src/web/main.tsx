import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/noto-sans-sc';
import App from './App';
import './styles.css';
import './print.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
