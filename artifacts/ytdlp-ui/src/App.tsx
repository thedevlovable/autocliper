import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Switch, Route, Redirect, Router as WouterRouter } from 'wouter';
import { AuthProvider } from './lib/auth';

// Lazy-loaded pages — each page becomes its own JS chunk so the initial
// bundle only ships what the user actually needs to see first.
const ClipperPage = lazy(() => import('./pages/ClipperPage'));
const Login = lazy(() => import('./pages/Login'));
const SignUp = lazy(() => import('./pages/SignUp'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Account = lazy(() => import('./pages/Account'));
const Admin = lazy(() => import('./pages/Admin'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Suspense fallback={<div className="min-h-screen bg-[#0d0d0d]" />}>
            <Switch>
              <Route path="/" component={ClipperPage} />
              <Route path="/login" component={Login} />
              <Route path="/signup" component={SignUp} />
              <Route path="/reset-password" component={ResetPassword} />
              {/* Legacy auth paths from the old provider */}
              <Route path="/sign-in/*?"><Redirect to="/login" /></Route>
              <Route path="/sign-up/*?"><Redirect to="/signup" /></Route>
              <Route path="/pricing" component={Pricing} />
              <Route path="/account" component={Account} />
              <Route path="/admin" component={Admin} />
              <Route path="/terms" component={Terms} />
              <Route path="/privacy" component={Privacy} />
              <Route><Redirect to="/" /></Route>
            </Switch>
          </Suspense>
        </AuthProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}

export default App;
