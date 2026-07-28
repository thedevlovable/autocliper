import { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { dark } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter } from 'wouter';
import ClipperPage from './pages/ClipperPage';
import Home from './pages/home';
import { ClerkEnabledCtx } from './clerk-context';

const queryClient = new QueryClient();

// undefined when VITE_CLERK_PUBLISHABLE_KEY is not set — we skip ClerkProvider entirely in that case
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

const clerkAppearance = {
  baseTheme: dark,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsVariant: 'blockButton' as const,
    socialButtonsPlacement: 'top' as const,
  },
  variables: {
    colorPrimary: '#D1FE17',
    colorForeground: '#ffffff',
    colorMutedForeground: '#999999',
    colorDanger: '#ff4444',
    colorBackground: '#111111',
    colorInput: '#1e1e1e',
    colorInputForeground: '#ffffff',
    colorNeutral: '#333333',
    fontFamily: '"Geist", system-ui, sans-serif',
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#1a1a1a] rounded-2xl w-[440px] max-w-full overflow-hidden border border-white/10',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-white font-black',
    headerSubtitle: 'text-white/50',
    socialButtonsBlockButton: 'bg-[#222] border border-white/10 hover:bg-[#2a2a2a] transition-colors',
    socialButtonsBlockButtonText: 'text-white font-semibold',
    formFieldLabel: 'text-white/70 text-sm',
    formFieldInput: 'bg-[#222] border-white/10 text-white',
    formButtonPrimary: 'bg-[#D1FE17] text-black font-black hover:bg-[#c5f010] transition-colors',
    footerActionLink: 'text-[#D1FE17] hover:text-[#c5f010]',
    footerActionText: 'text-white/50',
    dividerText: 'text-white/30',
    dividerLine: 'bg-white/10',
    identityPreviewEditButton: 'text-[#D1FE17]',
    logoBox: 'flex justify-center py-2',
    logoImage: 'h-10 w-10',
    alert: 'bg-red-500/10 border border-red-500/20',
    alertText: 'text-red-400',
    formFieldSuccessText: 'text-[#D1FE17]',
    otpCodeFieldInput: 'bg-[#222] border-white/10 text-white',
    footerAction: 'bg-transparent',
    main: 'gap-4',
    formFieldRow: 'gap-2',
  },
};

function SignInPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 py-12">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        appearance={clerkAppearance}
        forceRedirectUrl={basePath || '/'}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 py-12">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        appearance={clerkAppearance}
        forceRedirectUrl={basePath || '/'}
      />
    </div>
  );
}

// Invalidate query cache when user changes (sign-in / sign-out)
function CacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prevRef.current !== undefined && prevRef.current !== id) qc.clear();
      prevRef.current = id;
    });
  }, [addListener, qc]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkEnabledCtx.Provider value={true}>
        <QueryClientProvider client={queryClient}>
          <CacheInvalidator />
          <Switch>
            <Route path="/" component={ClipperPage} />
            <Route path="/downloader" component={Home} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
          </Switch>
        </QueryClientProvider>
      </ClerkEnabledCtx.Provider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      {clerkPubKey ? (
        <ClerkProviderWithRoutes />
      ) : (
        /* No Clerk key configured — render the app without auth (clip generation still works) */
        <ClerkEnabledCtx.Provider value={false}>
          <QueryClientProvider client={queryClient}>
            <Switch>
              <Route path="/" component={ClipperPage} />
              <Route path="/downloader" component={Home} />
            </Switch>
          </QueryClientProvider>
        </ClerkEnabledCtx.Provider>
      )}
    </WouterRouter>
  );
}

export default App;
