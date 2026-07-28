import { Link } from 'wouter';

export default function Login() {
  return (
    <div className="min-h-screen bg-black/5 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <Link href="/" className="font-black text-3xl tracking-tighter text-black">
            VIRALAI
          </Link>
        </div>
        
        <div className="bg-white p-8 md:p-10 rounded-[2rem] shadow-xl border border-black/10">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-black mb-2">Welcome back</h1>
            <p className="text-black/60 font-medium">Sign in to continue to your dashboard.</p>
          </div>

          <div className="space-y-4">
            <input 
              type="email" 
              placeholder="Email address" 
              className="w-full py-3.5 px-4 bg-black/5 border-transparent focus:bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 rounded-2xl outline-none transition-all font-medium"
            />
            
            <input 
              type="password" 
              placeholder="Password" 
              className="w-full py-3.5 px-4 bg-black/5 border-transparent focus:bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 rounded-2xl outline-none transition-all font-medium"
            />
            
            <div className="flex justify-end pt-1">
              <a href="#" className="text-sm font-bold text-black/60 hover:text-black transition-colors">Forgot password?</a>
            </div>
            
            <Link href="/dashboard" className="block w-full py-3.5 px-4 bg-primary text-black text-center font-black rounded-full hover:bg-[#bbf00e] hover:scale-[1.02] transition-all mt-2">
              Sign In &rarr;
            </Link>
          </div>
        </div>
        
        <div className="text-center mt-6 text-black/60 font-medium">
          Don't have an account? <Link href="/sign-up" className="text-black font-bold hover:underline">Sign up &rarr;</Link>
        </div>
      </div>
    </div>
  );
}
