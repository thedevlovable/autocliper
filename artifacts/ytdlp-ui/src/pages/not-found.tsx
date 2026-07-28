import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background text-foreground font-mono selection:bg-primary selection:text-primary-foreground relative overflow-hidden">
      
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none z-0"></div>

      <div className="text-center space-y-6 z-10">
        <h1 className="text-6xl font-bold text-primary tracking-tighter drop-shadow-[0_0_15px_rgba(16,185,129,0.5)]">404</h1>
        <p className="text-zinc-400 text-sm tracking-widest">TARGET_NOT_FOUND</p>
        <Link href="/" className="inline-block mt-4 px-6 py-3 bg-primary text-primary-foreground font-bold rounded hover:bg-primary/90 transition-colors shadow-[0_0_15px_rgba(16,185,129,0.2)] hover:shadow-[0_0_25px_rgba(16,185,129,0.4)]">
          RETURN_TO_HOME
        </Link>
      </div>
    </div>
  );
}
