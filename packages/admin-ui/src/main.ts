import { startApp } from './app';
import { applyStoredTheme, enableSpotlight } from './dom';

applyStoredTheme();
enableSpotlight();
startApp(document.getElementById('app')!);
