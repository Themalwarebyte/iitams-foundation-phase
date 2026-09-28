import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

export default function NotFound() {
  const { isAuthenticated } = useAuth();

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background px-6"
    >
      <div className="max-w-md text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Compass className="size-6" aria-hidden />
        </div>
        <p className="mt-6 text-sm font-semibold uppercase tracking-widest text-primary">
          Error 404
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Page not found
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The page you requested does not exist or may have been moved. If you
          followed a link from a report, contact the IITAMS administrator.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link to={isAuthenticated ? "/dashboard" : "/"}>
              {isAuthenticated ? "Back to dashboard" : "Back to home"}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/auth">Sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
