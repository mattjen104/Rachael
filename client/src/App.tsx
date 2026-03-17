import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CrtThemeProvider } from "@/lib/crt-theme";
import { TvModeProvider } from "@/hooks/use-tv-mode";
import TvShortcutOverlay from "@/components/tv/TvShortcutOverlay";
import AuthGate from "@/components/AuthGate";
import NotFound from "@/pages/not-found";
import Workspace from "@/pages/Workspace";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Workspace} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TvModeProvider>
        <CrtThemeProvider>
          <AuthGate>
            <TooltipProvider>
              <Toaster />
              <TvShortcutOverlay />
              <Router />
            </TooltipProvider>
          </AuthGate>
        </CrtThemeProvider>
      </TvModeProvider>
    </QueryClientProvider>
  );
}

export default App;
