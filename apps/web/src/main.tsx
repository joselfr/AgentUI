import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

registerSW({ immediate: true });

// Hauteur réellement visible (clavier mobile déduit) : Safari iOS ignore interactive-widget=resizes-content
// et se contente de recouvrir la page avec le clavier, puis de la faire défiler.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    if (window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
