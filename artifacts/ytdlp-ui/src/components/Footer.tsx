import { Link } from 'wouter';

export function Footer() {
  return (
    <footer className="bg-black text-white py-16 border-t border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          <div className="col-span-1 md:col-span-1">
            <Link href="/" className="font-black text-3xl tracking-tighter text-white">
              VIRALAI
            </Link>
            <p className="mt-4 text-white/60 text-sm">
              Your all-in-one tool for making money from viral videos with the power of AI.
            </p>
          </div>
          
          <div>
            <h4 className="font-semibold text-lg mb-4 text-primary">Product</h4>
            <ul className="space-y-3">
              <li><Link href="/#features" className="text-white/70 hover:text-white transition-colors">Features</Link></li>
              <li><Link href="/pricing" className="text-white/70 hover:text-white transition-colors">Pricing</Link></li>
              <li><Link href="/#compare" className="text-white/70 hover:text-white transition-colors">Compare</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-semibold text-lg mb-4 text-primary">Resources</h4>
            <ul className="space-y-3">
              <li><a href="#" className="text-white/70 hover:text-white transition-colors">Blog</a></li>
              <li><a href="#" className="text-white/70 hover:text-white transition-colors">Help Center</a></li>
              <li><a href="#" className="text-white/70 hover:text-white transition-colors">Community</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-semibold text-lg mb-4 text-primary">Legal</h4>
            <ul className="space-y-3">
              <li><a href="#" className="text-white/70 hover:text-white transition-colors">Terms of Service</a></li>
              <li><a href="#" className="text-white/70 hover:text-white transition-colors">Privacy Policy</a></li>
            </ul>
          </div>
        </div>
        
        <div className="mt-16 pt-8 border-t border-white/10 flex flex-col md:flex-row justify-between items-center">
          <p className="text-white/50 text-sm">© 2026 VIRALAI. All rights reserved.</p>
          <div className="flex space-x-6 mt-4 md:mt-0">
            <a href="#" className="text-white/50 hover:text-white transition-colors">Twitter</a>
            <a href="#" className="text-white/50 hover:text-white transition-colors">YouTube</a>
            <a href="#" className="text-white/50 hover:text-white transition-colors">TikTok</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
