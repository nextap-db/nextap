document.addEventListener('DOMContentLoaded',()=>{
  const items=document.querySelectorAll('.reveal');
  if(!('IntersectionObserver' in window)){items.forEach(el=>el.classList.add('visible'));}
  else{
    const observer=new IntersectionObserver((entries,obs)=>{
      entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');obs.unobserve(entry.target)}});
    },{threshold:.12,rootMargin:'0px 0px -40px 0px'});
    items.forEach(el=>observer.observe(el));
  }

  // Keep anchored sections clear of the sticky header on every navigation path.
  const navHeight=()=>document.querySelector('.nav')?.offsetHeight||82;
  document.querySelectorAll('a[href^="#"]').forEach(link=>{
    link.addEventListener('click',e=>{
      const id=link.getAttribute('href');
      if(!id||id==='#')return;
      const target=document.querySelector(id);
      if(!target)return;
      e.preventDefault();
      const y=target.getBoundingClientRect().top+window.scrollY-navHeight()-18;
      window.history.pushState(null,'',id);
      window.scrollTo({top:Math.max(0,y),behavior:'smooth'});
    });
  });

  // Correct the initial position when the page is opened directly with a hash.
  if(window.location.hash){
    requestAnimationFrame(()=>setTimeout(()=>{
      const target=document.querySelector(window.location.hash);
      if(target){
        const y=target.getBoundingClientRect().top+window.scrollY-navHeight()-18;
        window.scrollTo({top:Math.max(0,y),behavior:'auto'});
      }
    },20));
  }
});
