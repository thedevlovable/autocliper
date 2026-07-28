import { Link } from 'wouter';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';

export function Navbar() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="sticky top-10 md:top-[36px] z-40 bg-white/80 backdrop-blur-md border-b border-black/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex-shrink-0 flex items-center">
            <Link href="/" className="font-black text-2xl tracking-tighter text-black">
              VIRALAI
            </Link>
          </div>
          
          <div className="hidden md:flex items-center space-x-8">
            <div className="flex space-x-6 text-sm font-medium text-black/70">
              <Link href="/#features" className="hover:text-black transition-colors">Features ▾</Link>
              <Link href="/#templates" className="hover:text-black transition-colors">Templates ▾</Link>
              <Link href="/pricing" className="hover:text-black transition-colors">Pricing</Link>
              <Link href="/#compare" className="hover:text-black transition-colors">Compare</Link>
            </div>
            
            <div className="flex items-center space-x-4">
              <Link href="/login" className="text-sm font-medium text-black/70 hover:text-black transition-colors">
                Log in
              </Link>
              <Link href="/sign-up" className="bg-black text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-black/90 transition-transform hover:scale-105 active:scale-95 flex items-center gap-2">
                GET STARTED &rarr;
              </Link>
            </div>
          </div>

          <div className="md:hidden flex items-center">
            <button onClick={() => setIsOpen(!isOpen)} className="text-black">
              {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {isOpen && (
        <div className="md:hidden bg-white border-b border-black/5 absolute w-full">
          <div className="px-4 pt-2 pb-6 space-y-4 shadow-xl shadow-black/5">
            <Link href="/#features" className="block text-base font-medium text-black/80">Features</Link>
            <Link href="/#templates" className="block text-base font-medium text-black/80">Templates</Link>
            <Link href="/pricing" className="block text-base font-medium text-black/80">Pricing</Link>
            <Link href="/#compare" className="block text-base font-medium text-black/80">Compare</Link>
            <div className="pt-4 flex flex-col space-y-3">
              <Link href="/login" className="block text-center text-base font-medium text-black border border-black/10 py-2.5 rounded-full">
                Log in
              </Link>
              <Link href="/sign-up" className="block text-center bg-primary text-black py-2.5 rounded-full text-base font-bold">
                GET STARTED &rarr;
              </Link>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
