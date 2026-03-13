import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CrtThemeProvider } from "@/lib/crt-theme";
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
      <CrtThemeProvider>
        <AuthGate>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </AuthGate>
      </CrtThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
