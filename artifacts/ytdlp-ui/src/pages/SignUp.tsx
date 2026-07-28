import { Link } from 'wouter';
import { Star } from 'lucide-react';

export default function SignUp() {
  return (
    <div className="min-h-screen bg-black/5 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <Link href="/" className="font-black text-3xl tracking-tighter text-black">
            VIRALAI
          </Link>
        </div>
        
        <div className="bg-white p-8 md:p-10 rounded-[2rem] shadow-xl border border-black/10">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="flex -space-x-3 mb-4">
              <div className="w-10 h-10 rounded-full border-2 border-white bg-blue-500 z-30"></div>
              <div className="w-10 h-10 rounded-full border-2 border-white bg-red-500 z-20"></div>
              <div className="w-10 h-10 rounded-full border-2 border-white bg-green-500 z-10"></div>
            </div>
            <div className="text-sm font-bold text-black/60 tracking-wider uppercase mb-2">
              Trusted by 50,000+ creators
            </div>
            <h1 className="text-3xl font-black mb-2">Let's Get You Viral</h1>
            <p className="text-black/60 font-medium">Make viral videos and start earning in minutes.</p>
          </div>

          <div className="space-y-4">
            <button className="w-full flex items-center justify-center gap-3 py-3.5 px-4 bg-white border-2 border-black/10 rounded-full text-black font-bold hover:bg-black/5 transition-colors">
              <svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
                <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                  <path fill="#4285F4" d="M -3.264,51.509 C -3.264,50.719 -3.334,49.969 -3.454,49.239 L -14.754,49.239 L -14.754,53.749 L -8.284,53.749 C -8.574,55.229 -9.424,56.479 -10.684,57.329 L -10.684,60.329 L -6.824,60.329 C -4.564,58.239 -3.264,55.159 -3.264,51.509 Z"/>
                  <path fill="#34A853" d="M -14.754,63.239 C -11.514,63.239 -8.804,62.159 -6.824,60.329 L -10.684,57.329 C -11.764,58.049 -13.134,58.489 -14.754,58.489 C -17.884,58.489 -20.534,56.379 -21.484,53.529 L -25.464,53.529 L -25.464,56.619 C -23.494,60.539 -19.444,63.239 -14.754,63.239 Z"/>
                  <path fill="#FBBC05" d="M -21.484,53.529 C -21.734,52.809 -21.864,52.039 -21.864,51.239 C -21.864,50.439 -21.724,49.669 -21.484,48.949 L -21.484,45.859 L -25.464,45.859 C -26.284,47.479 -26.754,49.299 -26.754,51.239 C -26.754,53.179 -26.284,54.999 -25.464,56.619 L -21.484,53.529 Z"/>
                  <path fill="#EA4335" d="M -14.754,43.989 C -12.984,43.989 -11.404,44.599 -10.154,45.789 L -6.734,41.939 C -8.804,39.819 -11.514,38.489 -14.754,38.489 C -19.444,38.489 -23.494,41.189 -25.464,45.859 L -21.484,48.949 C -20.534,46.099 -17.884,43.989 -14.754,43.989 Z"/>
                </g>
              </svg>
              Continue with Google
            </button>
            
            <div className="flex items-center gap-4 py-2">
              <div className="h-px bg-black/10 flex-1"></div>
              <div className="text-sm font-medium text-black/40">or</div>
              <div className="h-px bg-black/10 flex-1"></div>
            </div>

            <input 
              type="email" 
              placeholder="name@example.com" 
              className="w-full py-3.5 px-4 bg-black/5 border-transparent focus:bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 rounded-2xl outline-none transition-all font-medium"
            />
            
            <Link href="/dashboard" className="block w-full py-3.5 px-4 bg-primary text-black text-center font-black rounded-full hover:bg-[#bbf00e] hover:scale-[1.02] transition-all">
              CONTINUE &rarr;
            </Link>
          </div>

          <div className="mt-8 flex flex-col items-center">
            <div className="flex text-yellow-400 mb-2">
              <Star fill="currentColor" className="w-5 h-5" />
              <Star fill="currentColor" className="w-5 h-5" />
              <Star fill="currentColor" className="w-5 h-5" />
              <Star fill="currentColor" className="w-5 h-5" />
              <Star fill="currentColor" className="w-5 h-5" />
            </div>
            <div className="text-black/60 font-medium text-sm">4.9/5 rating</div>
            
            <p className="mt-8 text-xs text-black/40 text-center">
              By continuing, you agree to our Terms & Privacy Policy
            </p>
          </div>
        </div>
        
        <div className="text-center mt-6 text-black/60 font-medium">
          Already have an account? <Link href="/login" className="text-black font-bold hover:underline">Log in</Link>
        </div>
      </div>
    </div>
  );
}
