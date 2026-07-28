import { Sidebar } from '../components/Sidebar';
import { tools } from '../lib/data';
import { Link } from 'wouter';
import { Sparkles, ArrowRight } from 'lucide-react';

export default function Dashboard() {
  const gradients = [
    "from-blue-500 to-cyan-400", "from-purple-500 to-pink-500", "from-orange-500 to-red-500",
    "from-green-400 to-emerald-600", "from-indigo-500 to-blue-600", "from-yellow-400 to-orange-500",
    "from-pink-500 to-rose-500", "from-teal-400 to-green-500", "from-fuchsia-500 to-purple-600"
  ];

  return (
    <div className="min-h-screen bg-white flex">
      <Sidebar />
      
      <main className="flex-1 ml-64 overflow-x-hidden">
        <div className="p-8 max-w-7xl mx-auto">
          <header className="mb-10">
            <h1 className="text-4xl font-black mb-2">Tools</h1>
            <p className="text-xl text-black/50 font-medium">Choose a tool to make videos.</p>
          </header>

          <div className="mb-12 overflow-hidden bg-black/5 rounded-2xl border border-black/5 py-4 relative">
            <div className="absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-[#F5F5F5] to-transparent z-10"></div>
            <div className="absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-[#F5F5F5] to-transparent z-10"></div>
            <div className="flex w-[300%] animate-scroll-left items-center">
              {[...tools, ...tools].map((tool, i) => (
                <div key={i} className="whitespace-nowrap mx-6 font-bold text-black/40 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-black/20" /> {tool.name}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tools.map((tool, i) => {
              const bgGradient = gradients[i % gradients.length];
              return (
                <Link key={tool.slug} href={`/dashboard/tools/${tool.slug}`} className="group block rounded-[2rem] border border-black/10 bg-white hover:border-primary hover:shadow-xl transition-all overflow-hidden flex flex-col h-full">
                  <div className={`aspect-[16/9] w-full bg-gradient-to-br ${bgGradient} relative overflow-hidden`}>
                    {tool.isNew && (
                      <div className="absolute top-4 left-4 bg-primary text-black text-[10px] font-black uppercase tracking-wider px-3 py-1 rounded-full z-10 shadow-sm">
                        NEW
                      </div>
                    )}
                    <div className="absolute top-4 right-4 bg-black/30 backdrop-blur-md text-white text-xs font-bold px-3 py-1 rounded-full z-10 border border-white/20">
                      {tool.cost}
                    </div>
                    <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors"></div>
                  </div>
                  
                  <div className="p-6 flex-1 flex flex-col">
                    <h3 className="text-xl font-black mb-2 group-hover:text-primary transition-colors">{tool.name}</h3>
                    <p className="text-black/60 font-medium text-sm flex-1">{tool.longDesc}</p>
                    
                    <div className="mt-6 pt-4 border-t border-black/5 flex items-center justify-between">
                      <div className="text-xs font-bold text-black/40 uppercase tracking-wider">{tool.category}</div>
                      <div className="flex items-center gap-1 text-sm font-bold text-black group-hover:text-primary transition-colors">
                        Try <ArrowRight className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
