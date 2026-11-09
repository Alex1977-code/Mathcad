import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';
import { AUTOSAVE } from './files';

/** Last line of defence: an unexpected error shows a recovery page instead of a white screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    const discard = () => {
      try { localStorage.removeItem(AUTOSAVE); } catch { /* ignore */ }
      location.reload();
    };
    return (
      <div className="crash">
        <h1>FormelWerk ist auf einen Fehler gestoßen</h1>
        <p>Das Dokument konnte nicht angezeigt werden: <code>{this.state.error.message}</code></p>
        <p>
          <button onClick={() => location.reload()}>Neu laden</button>{' '}
          <button onClick={discard}>Automatische Sicherung verwerfen und neu starten</button>
        </p>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
