import { Link, useLocation } from 'wouter';
import { LayoutGrid, Wrench, Folder, Compass, Plus, CreditCard } from 'lucide-react';

export function Sidebar() {
  const [location] = useLocation();

  const nav = [
    { icon: LayoutGrid, label: "Home", href: "/dashboard" },
    { icon: Wrench, label: "Tools", href: "/dashboard" },
    { icon: Folder, label: "Projects", href: "#" },
    { icon: Compass, label: "Discover", href: "#" },
  ];

  return (
    <div className="w-64 h-screen bg-[#FAFAFA] border-r border-black/10 flex flex-col fixed left-0 top-0">
      <div className="p-6">
        <Link href="/" className="font-black text-2xl tracking-tighter text-black block mb-8">
          VIRALAI
        </Link>
        
        <button className="w-full flex items-center justify-center gap-2 bg-primary text-black py-3 rounded-full font-bold hover:scale-[1.02] transition-transform shadow-sm">
          <Plus className="w-5 h-5" /> Create
        </button>
      </div>

      <div className="flex-1 px-4 space-y-1">
        {nav.map((item, i) => {
          const isActive = location === item.href || (item.label === "Tools" && location.startsWith("/dashboard/tools"));
          return (
            <Link 
              key={i} 
              href={item.href} 
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl font-semibold transition-colors ${isActive ? 'bg-black text-white' : 'text-black/60 hover:bg-black/5 hover:text-black'}`}
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </div>

      <div className="p-6 border-t border-black/5">
        <div className="bg-white border border-black/10 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center gap-2 font-bold mb-3">
            <CreditCard className="w-4 h-4 text-primary" /> Credits
          </div>
          <div className="text-sm font-semibold text-black/60 mb-2">250 credits remaining</div>
          <div className="h-2 w-full bg-black/5 rounded-full overflow-hidden">
            <div className="h-full bg-primary w-[70%] rounded-full"></div>
          </div>
          <Link href="/pricing" className="block text-center text-xs font-bold text-black mt-3 hover:underline">
            Upgrade Plan
          </Link>
        </div>
      </div>
    </div>
  );
}
