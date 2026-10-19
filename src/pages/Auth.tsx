import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import logo from "@/assets/logo.svg";
import { ArrowRight, Loader2, Mail, ShieldCheck, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { VisualBackground } from "@/components/VisualBackground";
import {
  OTP_NEWEST_CODE_GUIDANCE,
  canResendOtp,
  otpResendRemainingMs,
  requestOtpOnce,
} from "@/lib/authOtp";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Auth policy is authoritative from the deployment (server-side). The guest
  // button renders only when the deployment enables guest auth (development).
  const authPolicy = useQuery(api.session.getAuthPolicy, {});
  const guestEnabled = authPolicy?.guestEnabled === true;
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Timestamp of the last code REQUEST (successful or ambiguous). Drives the
  // explicit-resend cooldown; a resend is only ever a user action.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  useEffect(() => {
    if (sentAt === null) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sentAt]);

  const resendRemainingMs = otpResendRemainingMs(sentAt, clock);
  const resendSeconds = Math.ceil(resendRemainingMs / 1000);
  const resendEnabled = canResendOtp(sentAt, clock, isLoading);

  /**
   * Request one verification code. Completion of the request is ambiguous when
   * it fails with a timeout or generic server error: the code may already
   * have been stored and delivered. Convex Auth keeps only ONE active code per
   * account, so an automatic retry would silently invalidate the first email.
   * The request is therefore performed exactly once (OTP_MAX_AUTOMATIC_ATTEMPTS)
   * and any further attempt is an explicit user action with a cooldown.
   */
  const requestCode = async (email: string) => {
    const formData = new FormData();
    formData.append("email", email);
    const result = await requestOtpOnce(async () => {
      await signIn("email-otp", formData);
    });
    return { email, result };
  };

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setOtp("");
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const { result } = await requestCode(email);
    setIsLoading(false);
    if (result.ok) {
      setStep({ email });
      setSentAt(Date.now());
      setClock(Date.now());
      return;
    }
    if (result.kind === "transient") {
      // Ambiguous: move to the code step, explain the two possible outcomes
      // and let the cooldown-gated resend handle a missing email.
      setStep({ email });
      setSentAt(Date.now());
      setClock(Date.now());
    }
    setError(result.message);
  };

  const handleResend = async () => {
    if (step === "signIn" || !resendEnabled) return;
    setIsLoading(true);
    setError(null);
    setOtp("");
    const { result } = await requestCode(step.email);
    setIsLoading(false);
    if (result.ok) {
      setSentAt(Date.now());
      setClock(Date.now());
      return;
    }
    setError(result.message);
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);

      navigate(redirect);
    } catch (error) {
      // Generic on purpose: never expose server detail (and never reveal
      // whether the address has an account) in a verification failure.
      console.error("OTP verification error:", error);
      setError("The verification code you entered is incorrect or has expired.");
      setIsLoading(false);
      setOtp("");
    }
  };

  const useDifferentEmail = () => {
    setStep("signIn");
    setSentAt(null);
    setError(null);
    setOtp("");
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (error) {
      console.error("Guest login error:", error);
      setError(
        `Failed to sign in as guest: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <main
        id="main-content"
        className="relative flex flex-1 items-stretch"
      >
        {/* Brand panel with interactive background */}
        <div className="relative hidden w-[46%] lg:block">
          <VisualBackground className="absolute inset-0 h-full" particles>
            <div className="flex h-full flex-col justify-between p-10">
              <Link to="/" className="flex items-center gap-2.5 cursor-pointer">
                <img src={logo} alt="IITAMS" className="size-9 rounded-lg" />
                <div>
                  <p className="text-base font-bold tracking-tight text-white">
                    IITAMS
                  </p>
                  <p className="text-[10px] uppercase tracking-widest text-white/60">
                    ICT Audit & Assurance
                  </p>
                </div>
              </Link>
              <div>
                <h2 className="max-w-md text-3xl font-bold leading-tight tracking-tight text-white">
                  One platform for ICT audit, risk, compliance and continuity
                  oversight.
                </h2>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/70">
                  Purpose-built for ministries, departments, agencies and
                  counties. Every record permission-scoped, every action logged.
                </p>
                <ul className="mt-8 space-y-3 text-sm text-white/85">
                  {[
                    "Risk-based audit planning and findings follow-up",
                    "5×5 ICT risk model with heat-map analytics",
                    "Compliance across ISO 27001, NIST CSF & DPA 2019",
                    "Immutable audit logging for oversight bodies",
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2.5">
                      <ShieldCheck
                        className="mt-0.5 size-4 shrink-0 text-[#4EB5F5]"
                        aria-hidden
                      />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-white/50">
                Design language inspired by the Ministry of Information,
                Communications & the Digital Economy.
              </p>
            </div>
          </VisualBackground>
        </div>

        {/* Sign-in panel */}
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
          <div className="flex w-full max-w-md flex-col">
            <Link
              to="/"
              className="mb-8 flex items-center justify-center gap-2.5 lg:hidden"
            >
              <img src={logo} alt="IITAMS" className="size-9 rounded-lg" />
              <span className="text-lg font-bold tracking-tight">IITAMS</span>
            </Link>

            <Card className="border-border/70 shadow-none">
              {step === "signIn" ? (
                <>
                  <CardHeader className="text-center">
                    <CardTitle className="text-xl">Sign in to IITAMS</CardTitle>
                    <CardDescription>
                      Enter your official email to receive a one-time
                      verification code
                    </CardDescription>
                  </CardHeader>
                  <form onSubmit={handleEmailSubmit}>
                    <CardContent>
                      <div className="relative flex items-center gap-2">
                        <div className="relative flex-1">
                          <Mail
                            className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"
                            aria-hidden
                          />
                          <Input
                            name="email"
                            placeholder="name@go.ke"
                            type="email"
                            className="pl-9"
                            disabled={isLoading}
                            required
                            aria-label="Email address"
                          />
                        </div>
                        <Button
                          type="submit"
                          variant="outline"
                          size="icon"
                          disabled={isLoading}
                          aria-label="Send verification code"
                        >
                          {isLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ArrowRight className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      {error && (
                        <p role="alert" className="mt-2 text-sm text-destructive">
                          {error}
                        </p>
                      )}

                      <div className="mt-4">
                        <div className="relative">
                          <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                          </div>
                          <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                              {guestEnabled ? "Or" : ""}
                            </span>
                          </div>
                        </div>

                        {/* Development-only affordance: rendered strictly when
                            the deployment enables guest auth; the backend
                            independently refuses anonymous access in prod. */}
                        {guestEnabled && (
                          <Button
                            type="button"
                            variant="outline"
                            className="mt-4 w-full"
                            onClick={handleGuestLogin}
                            disabled={isLoading}
                          >
                            <UserX className="mr-2 h-4 w-4" />
                            Continue as Guest (development)
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </form>
                </>
              ) : (
                <>
                  <CardHeader className="mt-4 text-center">
                    <CardTitle>Check your email</CardTitle>
                    <CardDescription>
                      We&apos;ve sent a code to {step.email}
                    </CardDescription>
                  </CardHeader>
                  <form onSubmit={handleOtpSubmit}>
                    <CardContent className="pb-4">
                      <input type="hidden" name="email" value={step.email} />
                      <input type="hidden" name="code" value={otp} />

                      <div className="flex justify-center">
                        <InputOTP
                          value={otp}
                          onChange={setOtp}
                          maxLength={6}
                          disabled={isLoading}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              otp.length === 6 &&
                              !isLoading
                            ) {
                              const form = (e.target as HTMLElement).closest(
                                "form",
                              );
                              if (form) {
                                form.requestSubmit();
                              }
                            }
                          }}
                        >
                          <InputOTPGroup>
                            {Array.from({ length: 6 }).map((_, index) => (
                              <InputOTPSlot key={index} index={index} />
                            ))}
                          </InputOTPGroup>
                        </InputOTP>
                      </div>
                      {error && (
                        <p
                          role="alert"
                          className="mt-2 text-center text-sm text-destructive"
                        >
                          {error}
                        </p>
                      )}
                      <p className="mt-4 text-xs leading-5 text-muted-foreground">
                        {OTP_NEWEST_CODE_GUIDANCE}
                      </p>
                      <div className="mt-4 flex flex-col items-center gap-1 text-sm">
                        <span className="text-muted-foreground">
                          Didn&apos;t receive a code?
                        </span>
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto p-0"
                          onClick={handleResend}
                          disabled={!resendEnabled}
                          aria-live="polite"
                        >
                          {isLoading
                            ? "Sending…"
                            : resendRemainingMs > 0
                              ? `Resend code in ${resendSeconds}s`
                              : "Resend code"}
                        </Button>
                      </div>
                    </CardContent>
                    <CardFooter className="flex-col gap-2">
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={isLoading || otp.length !== 6}
                      >
                        {isLoading ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Verifying...
                          </>
                        ) : (
                          <>
                            Verify code
                            <ArrowRight className="ml-2 h-4 w-4" />
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={useDifferentEmail}
                        disabled={isLoading}
                        className="w-full"
                      >
                        Use different email
                      </Button>
                    </CardFooter>
                  </form>
                </>
              )}

              <div className="rounded-b-lg border-t bg-muted px-6 py-4 text-center text-xs text-muted-foreground">
                Protected by session tokens and audit logging. Access implies
                acceptance of monitoring.
              </div>
            </Card>

            <p className="mt-6 text-center text-xs text-muted-foreground">
              <Link to="/" className="underline underline-offset-4 hover:text-foreground">
                Return to the IITAMS overview
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
