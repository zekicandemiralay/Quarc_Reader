import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import RequiredUpdateGate from './components/RequiredUpdateGate';
import StorePromo from './components/StorePromo';
import './i18n';
import './index.css';
import { startOpenWith } from './lib/openWith';

// PDFs opened with this app from outside (file manager, share sheet, double-click) start arriving now.
startOpenWith();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <RequiredUpdateGate packageName="com.quarc.reader" />
      <StorePromo dialog />
    </BrowserRouter>
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
