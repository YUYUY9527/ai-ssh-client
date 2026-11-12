import ReactDOM from 'react-dom/client';
import App from './App';
import { installWebApi } from './lib/web';
import './index.css';

if (!window.electronAPI) {
  installWebApi();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
);
