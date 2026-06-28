import { Scissors } from "lucide-react";

interface AppHeaderProps {
  children?: React.ReactNode;
}

export function AppHeader({ children }: AppHeaderProps) {
  return (
    <header className="border-b border-border bg-card px-6 py-4 flex items-center gap-3 shrink-0">
      <div className="w-8 h-8 bg-primary rounded flex items-center justify-center text-primary-foreground">
        <Scissors className="w-5 h-5" strokeWidth={2.5} />
      </div>
      <div>
        <h1 className="font-bold tracking-tight leading-none">CLIP STUDIO</h1>
        <p className="text-[10px] uppercase font-mono text-muted-foreground tracking-wider">
          Viral Shorts Factory
        </p>
      </div>
      {children}
    </header>
  );
}
