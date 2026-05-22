import ReactDOM from 'react-dom/client';
import App from './App';
import { installNativeApi } from './lib/native';
import './index.css';

if (!window.electronAPI && '__TAURI_INTERNALS__' in window) {
  installNativeApi();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
);
