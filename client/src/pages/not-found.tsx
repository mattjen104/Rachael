export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background font-mono">
      <div className="w-full max-w-md mx-4 border border-border bg-card p-6">
        <div className="flex mb-4 gap-2 items-center">
          <span className="text-destructive text-2xl">[!]</span>
          <h1 className="text-2xl font-bold text-foreground">404 Page Not Found</h1>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          Did you forget to add the page to the router?
        </p>
      </div>
    </div>
  );
}
